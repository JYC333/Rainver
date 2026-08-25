import { spawn } from "node:child_process";

/**
 * The daemon discovers whatever the machine already has installed — it
 * never installs or manages a CLI's version tree itself (that would make it
 * a second `runtimeTools` service; ADR 0016 keeps execution-host capability
 * discovery to "what is on PATH right now").
 */
const PROBED_BINARIES = ["claude", "codex", "opencode", "git"] as const;

export type ProbedBinary = (typeof PROBED_BINARIES)[number];

export interface RuntimeOptions {
  models: string[];
  current_model: string | null;
  efforts: string[];
  current_effort: string | null;
}

export interface DaemonCapabilities {
  runtimes: ProbedBinary[];
  versions: Partial<Record<ProbedBinary, string>>;
  /** What each CLI is configured to run on when nothing is bound to it. */
  models: Partial<Record<ProbedBinary, string>>;
  /**
   * How hard each CLI is configured to have its model think. Separate from the
   * model because the two are chosen independently — the model is which brain,
   * the effort is how long it gets to use it.
   */
  reasoning: Partial<Record<ProbedBinary, string>>;
  /**
   * What each runtime says it can be set to, asked over ACP.
   *
   * Guessing this was wrong in both directions: Claude offers
   * `default/low/medium/high/xhigh/max` where a hardcoded list had three, and
   * its model ids carry their own brackets (`claude-fable-5[1m]`), so a model
   * and an effort cannot be recovered from one string. Only the runtime knows,
   * and asking is the difference between offering a real choice and offering a
   * plausible one.
   *
   * Absent for a runtime that could not be asked — not installed, not logged
   * in, or too slow to answer.
   */
  options: Partial<Record<ProbedBinary, RuntimeOptions>>;
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
const optionsCache = new Map<ProbedBinary, { at: number; value: RuntimeOptions | null }>();

/** Exported for tests: the next `detectCapabilities` re-asks every runtime. */
export function __clearRuntimeOptionsCache(): void {
  optionsCache.clear();
}

async function runtimeOptions(
  bin: ProbedBinary,
  ask: (bin: ProbedBinary) => Promise<RuntimeOptions | null>,
): Promise<RuntimeOptions | null> {
  const cached = optionsCache.get(bin);
  if (cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.value;
  const value = await ask(bin);
  optionsCache.set(bin, { at: Date.now(), value });
  return value;
}

export async function detectCapabilities(
  askOptions?: (bin: ProbedBinary) => Promise<RuntimeOptions | null>,
): Promise<DaemonCapabilities> {
  const runtimes: ProbedBinary[] = [];
  const versions: Partial<Record<ProbedBinary, string>> = {};
  const models: Partial<Record<ProbedBinary, string>> = {};
  const reasoning: Partial<Record<ProbedBinary, string>> = {};
  const options: Partial<Record<ProbedBinary, RuntimeOptions>> = {};
  for (const bin of PROBED_BINARIES) {
    const version = await probeVersion(bin);
    if (version === null) continue;
    runtimes.push(bin);
    versions[bin] = version;

    const asked = askOptions ? await runtimeOptions(bin, askOptions) : null;
    if (asked) {
      options[bin] = asked;
      // The runtime's own answer, which needs no parsing and cannot be wrong.
      if (asked.current_model) models[bin] = asked.current_model;
      if (asked.current_effort) reasoning[bin] = asked.current_effort;
      continue;
    }
    // Fall back to reading the config when the runtime could not be asked.
    const configured = await probeConfiguredModel(bin);
    if (configured?.model) models[bin] = configured.model;
    if (configured?.effort) reasoning[bin] = configured.effort;
  }
  return { runtimes, versions, models, reasoning, options };
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

async function probeConfiguredModel(bin: ProbedBinary): Promise<ConfiguredModel | null> {
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
