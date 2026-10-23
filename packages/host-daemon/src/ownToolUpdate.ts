import { execFile, spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { isOwnCliUpdateRuntimeKey, OWN_CLI_UPDATE_PACKAGES, type OwnCliUpdateRuntimeKey } from "@rainver/protocol";
import { helperProcessEnv } from "./providerBinding.js";
import { probeVersion } from "./capabilities.js";
import { updateOwnNpmTool } from "./ownNpmToolUpdate.js";

const exec = promisify(execFile);
/** The binary each updatable CLI is found as; which runtimes qualify is the protocol's list. */
const COMMANDS: Record<OwnCliUpdateRuntimeKey, string> = { claude_code: "claude", codex_cli: "codex" };

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = resolve(directory, name);
    try { await access(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  throw new Error(`${name} is not installed on this Host's PATH`);
}

function beneath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep);
}

/** Fixed recipes only, preserving the discovered installation's original location. */
export interface OwnToolUpdateRecipe {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The discovered CLI itself, whose version is read before and after. */
  executable: string;
  /** npm updates stage into a private prefix before replacing this installation. */
  npm?: { prefix: string; package: string; binary: string };
}

export async function ownToolUpdateCommand(runtimeKey: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnToolUpdateRecipe> {
  if (!isOwnCliUpdateRuntimeKey(runtimeKey)) throw new Error("Updating this own CLI installation is not supported yet");
  const recipe = { command: COMMANDS[runtimeKey], package: OWN_CLI_UPDATE_PACKAGES[runtimeKey] };
  if (process.platform === "win32") throw new Error("Own CLI updates currently require a Linux or macOS Host");
  const executable = await onPath(recipe.command, env);
  const target = await realpath(executable);
  const cleanEnv = helperProcessEnv(env);
  if (runtimeKey === "codex_cli" && beneath(target, join(env.HOME ?? homedir(), ".codex/packages/standalone/releases"))) {
    return { command: executable, args: ["update"], env: cleanEnv, executable };
  }
  if (runtimeKey === "claude_code" && beneath(target, join(env.HOME ?? homedir(), ".local/share/claude/versions"))) {
    return { command: executable, args: ["update"], env: cleanEnv, executable };
  }
  // A global npm package must live in the exact standard prefix tree. Do
  // not convert brew, standalone, pnpm or other installs into npm installs.
  const packageSuffix = join("lib", "node_modules", recipe.package) + sep;
  const at = target.lastIndexOf(sep + packageSuffix);
  if (at < 0) {
    // Standalone installers may copy the binary into a custom bin directory.
    // Probe only help; do not infer an install method from its name alone.
    if (runtimeKey === "codex_cli") {
      const help = await exec(executable, ["update", "--help"], { env: cleanEnv, timeout: 4000, maxBuffer: 16 * 1024 }).catch(() => null);
      if (help && /Usage:\s+codex update\b/.test(help.stdout)) return { command: executable, args: ["update"], env: cleanEnv, executable };
    }
    throw new Error("This own CLI was not installed by a supported updater; update it using its original installation method");
  }
  const prefix = target.slice(0, at);
  const npm = join(prefix, "bin", "npm");
  await access(npm, constants.X_OK).catch(() => { throw new Error("The original npm installation is unavailable"); });
  // Pin Node to this prefix too; a different system Node must not silently
  // redirect the update into another version manager's global tree.
  await access(join(prefix, "bin", "node"), constants.X_OK);
  return { command: npm, args: ["install", "--global", "--prefix", prefix, `${recipe.package}@latest`], env: { ...cleanEnv, PATH: `${dirname(npm)}${delimiter}${cleanEnv.PATH ?? ""}` }, executable,
    npm: { prefix, package: recipe.package, binary: recipe.command } };
}

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

/**
 * Runs an updater to completion. Its output is streamed and discarded except
 * for a bounded tail kept for the failure message: npm and vendor updaters
 * print an unbounded amount, and a buffer cap that kills the child would stop
 * an install half way through.
 */
export function runUpdater(recipe: Pick<OwnToolUpdateRecipe, "command" | "args" | "env">, timeoutMs = UPDATE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // No shell, stdin, sudo, provider credentials or caller-supplied argv.
    const child = spawn(recipe.command, recipe.args, { env: recipe.env, cwd: homedir(), stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    timer.unref();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolvePromise();
      const reason = timedOut ? "timed out" : signal ? `stopped by ${signal}` : `exited with code ${code}`;
      const detail = tail.trim();
      reject(new Error(`The own CLI updater ${reason}${detail ? `: ${detail}` : ""}`));
    });
  });
}

/** What a finished update changed; equal versions mean the CLI was already current. */
export interface OwnToolUpdateOutcome { from_version: string | null; to_version: string | null }

/** The release triple a `--version` line names, or the line itself when it names none. */
function versionOf(reported: string | null): string | null {
  if (!reported) return null;
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(reported)?.[1] ?? reported;
}

export async function updateOwnTool(runtimeKey: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnToolUpdateOutcome> {
  const recipe = await ownToolUpdateCommand(runtimeKey, env);
  const from = versionOf(await probeVersion(recipe.executable, 4000, { env: recipe.env }));
  let reported: string | null;
  if (recipe.npm) reported = await updateOwnNpmTool(recipe, runUpdater);
  else {
    await runUpdater(recipe);
    reported = await probeVersion(recipe.executable, 4000, { env: recipe.env });
  }
  const to = versionOf(reported);
  if (!to) throw new Error("The updater finished, but the CLI is unavailable or failed its version check");
  return { from_version: from, to_version: to };
}
